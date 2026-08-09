# 标准库
net = require 'net'
http = require 'http'
url = require 'url'
fs = require 'fs'
os = require 'os'
spawn = require('child_process').spawn

# 三方库
_ = require 'underscore'

logger = require './logger.js'
log = logger.createLogger name: "SRVPro"

merge = require 'deepmerge'

loadJSON = (file) -> JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

#heapdump = require 'heapdump'

# 配置
if not fs.existsSync('./config')
  fs.mkdirSync('./config')

setting_save = (settings) ->
  fs.writeFileSync(settings.file, JSON.stringify(settings, null, 2))
  return

setting_change = (settings, path, val) ->
  # path should be like "modules:welcome"
  log.info("setting changed", path, val) if _.isString(val)
  path=path.split(':')
  if path.length == 0
    settings[path[0]]=val
  else
    target=settings
    while path.length > 1
      key=path.shift()
      target=target[key]
    key = path.shift()
    target[key] = val
  setting_save(settings)
  return

# 读取配置
default_config = loadJSON('./data/default_config.json')
try
  config = loadJSON('./config/config.json')
catch
  config = {}
settings = merge(default_config, config, { arrayMerge: (destination, source) -> source })

setting_save(settings)

# 读取数据
default_data = loadJSON('./data/default_data.json')

try
  admin_config = loadJSON('./config/admin_user.json')
catch
  admin_config = default_data.users
admin_users = admin_config.users or {}

authenticate = (username, password) ->
  return false unless _.isString(username) and _.isString(password)
  return false unless Object.prototype.hasOwnProperty.call(admin_users, username)
  user = admin_users[username]
  return user is password if _.isString(user)
  return !!(user and user.enabled != false and _.isString(user.password) and user.password is password)

try
  cppversion = parseInt(fs.readFileSync('ygopro/gframe/config.h', 'utf8').match(/PRO_VERSION\s?=\s?([x\dABCDEF]+)/)[1], '16')
  setting_change(settings, "version", cppversion)
  log.info "ygopro version 0x"+settings.version.toString(16), "(from source code)"
catch
  #settings.version = settings.version_default
  log.info "ygopro version 0x"+settings.version.toString(16), "(from config)"

# 组件
ygopro = require './ygopro.js'

# 获取可用内存
memory_usage = 0
get_memory_usage = ()->
  total_memory = os.totalmem()
  available_memory = os.freemem()
  if process.platform == 'linux'
    try
      mem_available = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m)
      available_memory = parseInt(mem_available[1], 10) * 1024 if mem_available
    catch
  memory_usage = if total_memory then (1 - available_memory / total_memory) * 100 else 99
  return
get_memory_usage()
setInterval(get_memory_usage, 3000)

ROOM_all = []
ROOM_private_players_scores = {}

ROOM_kick = (name, callback)->
  found = false
  for room in ROOM_all when room and room.established and (name == "all" or name == room.process_pid.toString() or name == room.name)
    found = true
    if room.duel_stage != ygopro.constants.DUEL_STAGE.BEGIN
      room.scores[room.dueling_players[0].name_vpass] = 0
      room.scores[room.dueling_players[1].name_vpass] = 0
    room.kicked = true
    room.process.kill()
    room.delete()
  callback(null, found)
  return


ROOM_player_win = (name, players_scores)->
  if !players_scores[name]
    players_scores[name]={win:0, lose:0, flee:0, combo:0}
  players_scores[name].win = players_scores[name].win + 1
  players_scores[name].combo = players_scores[name].combo + 1
  return

ROOM_player_lose = (name, players_scores)->
  if !players_scores[name]
    players_scores[name]={win:0, lose:0, flee:0, combo:0}
  players_scores[name].lose = players_scores[name].lose + 1
  players_scores[name].combo = 0
  return

ROOM_player_flee = (name, players_scores)->
  if !players_scores[name]
    players_scores[name]={win:0, lose:0, flee:0, combo:0}
  players_scores[name].flee = players_scores[name].flee + 1
  players_scores[name].combo = 0
  return

ROOM_player_get_score = (player, players_scores)->
  name = player.name_vpass
  score = players_scores[name]
  if !score
    return "#{player.name} ${random_score_blank}"
  total = score.win + score.lose
  if score.win < 2 and total < 3
    return "#{player.name} ${random_score_not_enough}"
  if score.combo >= 2
    return "${random_score_part1}#{player.name} ${random_score_part2} #{Math.ceil(score.win/total*100)}${random_score_part3} #{Math.ceil(score.flee/total*100)}${random_score_part4_combo}#{score.combo}${random_score_part5_combo}"
    #return player.name + " 的今日战绩：胜率" + Math.ceil(score.win/total*100) + "%，逃跑率" + Math.ceil(score.flee/total*100) + "%，" + score.combo + "连胜中！"
  else
    return "${random_score_part1}#{player.name} ${random_score_part2} #{Math.ceil(score.win/total*100)}${random_score_part3} #{Math.ceil(score.flee/total*100)}${random_score_part4}"
  return

ROOM_record_match_scores = (score_array, players_scores)->
  if score_array.length == 2
    if score_array[0].score != score_array[1].score
      if score_array[0].score > score_array[1].score
        ROOM_player_win(score_array[0].name_vpass, players_scores)
        ROOM_player_lose(score_array[1].name_vpass, players_scores)
      else
        ROOM_player_win(score_array[1].name_vpass, players_scores)
        ROOM_player_lose(score_array[0].name_vpass, players_scores)
  if score_array.length == 1 # same name
    ROOM_player_win(score_array[0].name_vpass, players_scores)
    ROOM_player_lose(score_array[0].name_vpass, players_scores)
  return

ROOM_get_scores = (players_scores, limit)->
  scores_pair = _.pairs players_scores
  scores_by_lose = _.sortBy(scores_pair, (score)-> return score[1].lose).reverse() # 败场由高到低
  scores_by_win = _.sortBy(scores_by_lose, (score)-> return score[1].win).reverse() # 先按胜场、再按败场排序
  if limit? then _.first(scores_by_win, limit) else scores_by_win

if settings.modules.max_rooms_count
  rooms_count=0
  get_rooms_count = ()->
    _rooms_count=0
    for room in ROOM_all when room and room.established
      _rooms_count++
    rooms_count=_rooms_count
    setTimeout get_rooms_count, 1000
    return
  setTimeout get_rooms_count, 1000

ROOM_find_or_create_by_name = (name)->
  if room = ROOM_find_by_name(name)
    return room
  else if memory_usage >= 90 or (settings.modules.max_rooms_count and rooms_count >= settings.modules.max_rooms_count)
    return null
  else
    return new Room(name)

ROOM_find_by_name = (name)->
  result = _.find ROOM_all, (room)->
    return room and room.name == name
  return result

ROOM_validate = (name)->
  client_name_and_pass = name.split('$', 2)
  client_name = client_name_and_pass[0]
  client_pass = client_name_and_pass[1]
  return true if !client_pass
  !_.find ROOM_all, (room)->
    return false unless room
    room_name_and_pass = room.name.split('$', 2)
    room_name = room_name_and_pass[0]
    room_pass = room_name_and_pass[1]
    client_name == room_name and client_pass != room_pass

CLIENT_kick = (client) ->
  if !client
    return false
  client.system_kicked = true
  client.destroy()
  return true

SERVER_kick = (server) ->
  if !server
    return false
  server.system_kicked = true
  server.destroy()
  return true

class Room
  constructor: (name, @hostinfo) ->
    @name = name
    @players = []
    @established = false
    @scores = {}
    @duel_count = 0
    @turn = 0
    @duel_stage = ygopro.constants.DUEL_STAGE.BEGIN
    ROOM_all.push this

    @hostinfo ||= JSON.parse(JSON.stringify(settings.hostinfo))
    delete @hostinfo.comment

    if name[0...2] == 'M#'
      @hostinfo.mode = 1
    else if name[0...2] == 'T#'
      @hostinfo.mode = 2
      @hostinfo.start_lp = 16000

    else if (param = name.match /^(\d)(\d)(T|F)(T|F)(T|F)(\d+),(\d+),(\d+)/i)
      @hostinfo.rule = parseInt(param[1])
      @hostinfo.mode = parseInt(param[2])
      if param[3] == 'T' then @hostinfo.duel_rule = 3
      @hostinfo.no_check_deck = param[4] == 'T'
      @hostinfo.no_shuffle_deck = param[5] == 'T'
      @hostinfo.start_lp = parseInt(param[6])
      @hostinfo.start_hand = parseInt(param[7])
      @hostinfo.draw_count = parseInt(param[8])

    else if ((param = name.match /(.+)#/) != null)
      rule = param[1].toUpperCase()

      if (rule.match /(^|，|,)(M|MATCH)(，|,|$)/)
        @hostinfo.mode = 1

      if (rule.match /(^|，|,)(T|TAG)(，|,|$)/)
        @hostinfo.mode = 2
        @hostinfo.start_lp = 16000

      if (rule.match /(^|，|,)(TCGONLY|TO)(，|,|$)/)
        @hostinfo.rule = 1

      if (rule.match /(^|，|,)(OCGONLY|OO)(，|,|$)/)
        @hostinfo.rule = 0

      if (rule.match /(^|，|,)(SC|CCG)(，|,|$)/)
        @hostinfo.rule = 2
        @hostinfo.lflist = -1

      if (rule.match /(^|，|,)(OT|TCG)(，|,|$)/)
        @hostinfo.rule = 5

      if (param = rule.match /(^|，|,)LP(\d+)(，|,|$)/)
        start_lp = parseInt(param[2])
        if (start_lp <= 0) then start_lp = 1
        if (start_lp >= 99999) then start_lp = 99999
        @hostinfo.start_lp = start_lp

      if (param = rule.match /(^|，|,)(TIME|TM|TI)(\d+)(，|,|$)/)
        time_limit = parseInt(param[3])
        if (time_limit < 0) then time_limit = 180
        if (time_limit >= 1 and time_limit <= 60) then time_limit = time_limit * 60
        if (time_limit >= 999) then time_limit = 999
        @hostinfo.time_limit = time_limit

      if (param = rule.match /(^|，|,)(START|ST)(\d+)(，|,|$)/)
        start_hand = parseInt(param[3])
        if (start_hand <= 0) then start_hand = 1
        if (start_hand >= 40) then start_hand = 40
        @hostinfo.start_hand = start_hand

      if (param = rule.match /(^|，|,)(DRAW|DR)(\d+)(，|,|$)/)
        draw_count = parseInt(param[3])
        if (draw_count >= 35) then draw_count = 35
        @hostinfo.draw_count = draw_count

      if (param = rule.match /(^|，|,)(LFLIST|LF)(\d+)(，|,|$)/)
        lflist = parseInt(param[3]) - 1
        @hostinfo.lflist = lflist

      if (rule.match /(^|，|,)(NOLFLIST|NF)(，|,|$)/)
        @hostinfo.lflist = -1

      if (rule.match /(^|，|,)(NOUNIQUE|NU)(，|,|$)/)
        @hostinfo.rule = 4

      if (rule.match /(^|，|,)(NOCHECK|NC)(，|,|$)/)
        @hostinfo.no_check_deck = true

      if (rule.match /(^|，|,)(NOSHUFFLE|NS)(，|,|$)/)
        @hostinfo.no_shuffle_deck = true

      if (rule.match /(^|，|,)(IGPRIORITY|PR)(，|,|$)/) # deprecated
        @hostinfo.duel_rule = 4

      if (param = rule.match /(^|，|,)(DUELRULE|MR)(\d+)(，|,|$)/)
        duel_rule = parseInt(param[3])
        if duel_rule and duel_rule > 0 and duel_rule <= 5
          @hostinfo.duel_rule = duel_rule

      if (rule.match /(^|，|,)(NOWATCH|NW)(，|,|$)/)
        @hostinfo.no_watch = true

    @hostinfo.replay_mode = 0 # 0x1: Save the replays in file. 0x2: Block the replays to observers.

    param = [0, @hostinfo.lflist, @hostinfo.rule, @hostinfo.mode, @hostinfo.duel_rule,
      (if @hostinfo.no_check_deck then 'T' else 'F'), (if @hostinfo.no_shuffle_deck then 'T' else 'F'),
      @hostinfo.start_lp, @hostinfo.start_hand, @hostinfo.draw_count, @hostinfo.time_limit, @hostinfo.replay_mode]

    try
      @process = spawn './ygopro', param, {cwd: 'ygopro'}
      @process_pid = @process.pid
      @process.on 'error', (err)=>
        log.warn 'CREATE ROOM ERROR', err
        _.each @players, (player)->
          ygopro.stoc_die(player, "${create_room_failed}")
        this.delete()
        return
      @process.on 'exit', (code)=>
        @disconnector = 'server' unless @disconnector
        this.delete()
        return
      @process.stdout.setEncoding('utf8')
      @process.stdout.once 'data', (data)=>
        @established = true
        @port = parseInt data
        _.each @players, (player)=>
          player.server.connect @port, '127.0.0.1', ->
            player.server.write buffer for buffer in player.pre_establish_buffers
            player.established = true
            player.pre_establish_buffers = []
            return
          return
        return
      @process.stderr.on 'data', (data)=>
        data = "Debug: " + data
        data = data.replace(/\n$/, "")
        log.info "YGOPRO " + data
        ygopro.stoc_send_chat_to_room this, data, ygopro.constants.COLORS.RED
        @ygopro_error_length = if @ygopro_error_length then @ygopro_error_length + data.length else data.length
        if @ygopro_error_length > 10000
          @process.kill()
        return
    catch e
      log.warn 'CREATE ROOM FAIL', e
      @error = "${create_room_failed}"
  delete: ->
    return if @deleted
    #log.info 'room-delete', this.name, ROOM_all.length
    score_array=[]
    for name, score of @scores
      score_array.push { name: name.split('$')[0], score: score, name_vpass: name }
    if settings.modules.private_duel.record_match_scores and !@kicked
      # Arena 不创建 Tag 房，手工 Tag 房的排行榜完整性不在本分支支持范围内。
      if @hostinfo.mode != 2
        ROOM_record_match_scores(score_array, ROOM_private_players_scores)

    @players = []
    @deleted = true
    index = _.indexOf(ROOM_all, this)
    ROOM_all[index] = null unless index == -1
    return

  connect: (client)->
    @players.push client
    if @established
      client.server.connect @port, '127.0.0.1', ->
        client.server.write buffer for buffer in client.pre_establish_buffers
        client.established = true
        client.pre_establish_buffers = []
        return
    return

  disconnect: (client, error)->
    #log.info(client.name, @duel_stage != ygopro.constants.DUEL_STAGE.BEGIN, @disconnector, @players.length)
    index = _.indexOf(@players, client)
    @players.splice(index, 1) unless index == -1
    if @duel_stage != ygopro.constants.DUEL_STAGE.BEGIN and @disconnector != 'server' and client.pos < 4
      @finished = true
      @scores[client.name_vpass] = -9
      if settings.modules.private_duel.record_match_scores
        ROOM_player_flee(client.name_vpass, ROOM_private_players_scores)
    if @players.length
      ygopro.stoc_send_chat_to_room this, "#{client.name} ${left_game}" + if error then ": #{error}" else ''
      #client.room = null
    else
      @process.kill()
      #client.room = null
      this.delete()
    SERVER_kick(client.server)
    return

# 网络连接
net.createServer (client) ->
  client.ip = client.remoteAddress
  client.is_local = client.ip and client.ip.includes('127.0.0.1')

  # server stand for the connection to ygopro server process
  server = new net.Socket()
  client.server = server
  server.client = client

  client.setTimeout(2000) #连接前超时2秒

  # 释放处理
  client.on 'close', (had_error) ->
    #log.info "client closed", client.name, had_error, client.closed, client.room_closed
    room=ROOM_all[client.rid]
    unless client.room_closed
      client.room_closed = true
      if room
        room.disconnect(client)
      else
        SERVER_kick(client.server)
    return

  client.on 'error', (error)->
    #log.info "client error", client.name, error
    room=ROOM_all[client.rid]
    unless client.room_closed
      client.room_closed = true
      if room
        room.disconnect(client, error)
      else
        SERVER_kick(client.server)
    return

  client.on 'timeout', ()->
    client.destroy()
    return

  server.on 'close', (had_error) ->
    server.room_closed = true unless server.room_closed
    if !server.client
      return
    #log.info "server closed", server.client.name, had_error
    room=ROOM_all[server.client.rid]
    room.disconnector = 'server' if room and !server.system_kicked
    unless server.client.room_closed
      ygopro.stoc_send_chat(server.client, "${server_closed}", ygopro.constants.COLORS.RED)
      CLIENT_kick(server.client)
    return

  server.on 'error', (error)->
    server.room_closed = error
    if !server.client
      return
    #log.info "server error", client.name, error
    room=ROOM_all[server.client.rid]
    room.disconnector = 'server' if room and !server.system_kicked
    unless server.client.room_closed
      ygopro.stoc_send_chat(server.client, "${server_error}: #{error}", ygopro.constants.COLORS.RED)
      CLIENT_kick(server.client)
    return

  if client.ip == undefined
    log.info 'CLIENT IP undefined'
    CLIENT_kick(client)
    return

  # 需要重构
  # 客户端到服务端(ctos)协议分析

  client.pre_establish_buffers = new Array()

  client.on 'data', (ctos_buffer) ->
    if client.server
      #ctos_buffer = Buffer.alloc(0)
      ctos_message_length = 0
      ctos_proto = 0
      #ctos_buffer = Buffer.concat([ctos_buffer, data], ctos_buffer.length + data.length) #buffer的错误使用方式，好孩子不要学

      datas = []

      looplimit = 0

      while true
        if ctos_message_length == 0
          if ctos_buffer.length >= 2
            ctos_message_length = ctos_buffer.readUInt16LE(0)
          else
            log.warn("bad ctos_buffer length", client.ip) unless ctos_buffer.length == 0
            break
        else if ctos_proto == 0
          if ctos_buffer.length >= 3
            ctos_proto = ctos_buffer.readUInt8(2)
          else
            log.warn("bad ctos_proto length", client.ip)
            break
        else
          if ctos_buffer.length >= 2 + ctos_message_length
            #console.log "CTOS", ygopro.constants.CTOS[ctos_proto]
            cancel = false
            b = ctos_buffer.slice(3, ctos_message_length - 1 + 3)
            info = null
            struct = ygopro.structs[ygopro.proto_structs.CTOS[ygopro.constants.CTOS[ctos_proto]]]
            if struct
              struct._setBuff(b)
              info = _.clone(struct.fields)
            if ygopro.ctos_follows[ctos_proto]
              result = ygopro.ctos_follows[ctos_proto].callback b, info, client, client.server, datas
              if result and ygopro.ctos_follows[ctos_proto].synchronous
                cancel = true
            datas.push ctos_buffer.slice(0, 2 + ctos_message_length) unless cancel
            ctos_buffer = ctos_buffer.slice(2 + ctos_message_length)
            ctos_message_length = 0
            ctos_proto = 0
          else
            log.warn("bad ctos_message length", client.ip, ctos_buffer.length, ctos_message_length, ctos_proto) if ctos_message_length != 17735
            break

        looplimit++
        #log.info(looplimit)
        if looplimit > 800
          log.info("error ctos", client.name, client.ip)
          CLIENT_kick(client)
          break
      if client.established
        client.server.write buffer for buffer in datas
      else
        client.pre_establish_buffers.push buffer for buffer in datas

    return

  # 服务端到客户端(stoc)
  server.on 'data', (stoc_buffer)->
    #stoc_buffer = Buffer.alloc(0)
    stoc_message_length = 0
    stoc_proto = 0
    #stoc_buffer = Buffer.concat([stoc_buffer, data], stoc_buffer.length + data.length) #buffer的错误使用方式，好孩子不要学

    #unless ygopro.stoc_follows[stoc_proto] and ygopro.stoc_follows[stoc_proto].synchronous
    #server.client.write data
    datas = []

    looplimit = 0

    while true
      if stoc_message_length == 0
        if stoc_buffer.length >= 2
          stoc_message_length = stoc_buffer.readUInt16LE(0)
        else
          log.warn("bad stoc_buffer length", server.client.ip) unless stoc_buffer.length == 0
          break
      else if stoc_proto == 0
        if stoc_buffer.length >= 3
          stoc_proto = stoc_buffer.readUInt8(2)
        else
          log.warn("bad stoc_proto length", server.client.ip)
          break
      else
        if stoc_buffer.length >= 2 + stoc_message_length
          #console.log "STOC", ygopro.constants.STOC[stoc_proto]
          cancel = false
          b = stoc_buffer.slice(3, stoc_message_length - 1 + 3)
          info = null
          struct = ygopro.structs[ygopro.proto_structs.STOC[ygopro.constants.STOC[stoc_proto]]]
          if struct
            struct._setBuff(b)
            info = _.clone(struct.fields)
          if ygopro.stoc_follows[stoc_proto]
            result = ygopro.stoc_follows[stoc_proto].callback b, info, server.client, server, datas
            if result and ygopro.stoc_follows[stoc_proto].synchronous
              cancel = true
          datas.push stoc_buffer.slice(0, 2 + stoc_message_length) unless cancel
          stoc_buffer = stoc_buffer.slice(2 + stoc_message_length)
          stoc_message_length = 0
          stoc_proto = 0
        else
          log.warn("bad stoc_message length", server.client.ip)
          break

      looplimit++
      #log.info(looplimit)
      if looplimit > 800
        log.info("error stoc", server.client.name)
        server.destroy()
        break
    if server.client and !server.client.room_closed
      server.client.write buffer for buffer in datas

    return
  return
.listen settings.port, ->
  log.info "server started", settings.port
  return

if settings.modules.stop
  log.info "NOTE: server not open due to config, ", settings.modules.stop

# 功能模块
# return true to cancel a synchronous message

ygopro.ctos_follow 'PLAYER_INFO', true, (buffer, info, client, server, datas)->
  # checkmate use username$password, but here don't
  # so remove the password
  name_full =info.name.split("$")
  name = name_full[0]
  vpass = name_full[1]
  if vpass and !vpass.length
    vpass = null
  struct = ygopro.structs["CTOS_PlayerInfo"]
  struct._setBuff(buffer)
  struct.set("name", name)
  buffer = struct.buffer
  client.name = name
  client.vpass = vpass
  client.name_vpass = if vpass then name + "$" + vpass else name

  client.lang = 'zh-cn'
  return false

ygopro.ctos_follow 'JOIN_GAME', false, (buffer, info, client, server, datas)->
#log.info info
  info.pass=info.pass.trim()
  client.pass = info.pass
  if settings.modules.stop
    ygopro.stoc_die(client, settings.modules.stop)

  else if info.version != settings.version # and (info.version < 9020 or settings.version != 4927) #强行兼容23333版
    ygopro.stoc_send_chat(client, (if info.version < settings.version then settings.modules.update else settings.modules.wait_update), ygopro.constants.COLORS.RED)
    ygopro.stoc_send client, 'ERROR_MSG', {
      msg: 4
      code: settings.version
    }
    CLIENT_kick(client)

  else if !info.pass.length
    ygopro.stoc_die(client, "${blank_room_name}")

  else if !client.name or client.name==""
    ygopro.stoc_die(client, "${bad_user_name}")

  else if info.pass.length && !ROOM_validate(info.pass)
    ygopro.stoc_die(client, "${invalid_password_room}")

  else
    #log.info 'join_game',info.pass, client.name
    room = ROOM_find_or_create_by_name(info.pass)
    if !room
      ygopro.stoc_die(client, settings.modules.full)
    else if room.error
      ygopro.stoc_die(client, room.error)
    else if room.duel_stage != ygopro.constants.DUEL_STAGE.BEGIN
      ygopro.stoc_die(client, "${watch_denied}")
    else if room.hostinfo.no_watch and room.players.length >= (if room.hostinfo.mode == 2 then 4 else 2)
      ygopro.stoc_die(client, "${watch_denied_room}")
    else
      client.setTimeout(300000) #连接后超时5分钟
      client.rid = _.indexOf(ROOM_all, room)
      room.connect(client)
  return

ygopro.stoc_follow 'JOIN_GAME', false, (buffer, info, client, server, datas)->
  #欢迎信息
  room=ROOM_all[client.rid]
  return unless room
  if settings.modules.welcome
    ygopro.stoc_send_chat(client, settings.modules.welcome, ygopro.constants.COLORS.GREEN)
  if settings.modules.private_duel.record_match_scores
    ygopro.stoc_send_chat_to_room(room, ROOM_player_get_score(client, ROOM_private_players_scores), ygopro.constants.COLORS.GREEN)
    for player in room.players when player.pos != 7 and player != client
      ygopro.stoc_send_chat(client, ROOM_player_get_score(player, ROOM_private_players_scores), ygopro.constants.COLORS.GREEN)
  return

ygopro.stoc_follow 'GAME_MSG', true, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  msg = buffer.readInt8(0)
  msg_name = ygopro.constants.MSG[msg]

  #log.info 'MSG', msg_name
  if msg_name == 'START'
    playertype = buffer.readUInt8(1)
    client.is_first = !(playertype & 0xf)
    client.lp = room.hostinfo.start_lp
    room.duel_stage = ygopro.constants.DUEL_STAGE.DUELING
    if client.pos == 0
      room.turn = 0
      room.duel_count++

  #ygopro.stoc_send_chat_to_room(room, "LP跟踪调试信息: #{client.name} 初始LP #{client.lp}")

  if msg_name == 'NEW_TURN'
    if client.pos == 0
      room.turn++

  if msg_name == 'WIN' and client.pos == 0
    pos = buffer.readUInt8(1)
    pos = 1 - pos unless client.is_first or pos == 2 or room.duel_stage != ygopro.constants.DUEL_STAGE.DUELING
    pos = pos * 2 if pos >= 0 and room.hostinfo.mode == 2
    reason = buffer.readUInt8(2)
    #log.info {winner: pos, reason: reason}
    #room.duels.push {winner: pos, reason: reason}
    room.winner = pos
    room.turn = 0
    room.duel_stage = ygopro.constants.DUEL_STAGE.END
    if room and !room.finished and room.dueling_players[pos]
      room.winner_name = room.dueling_players[pos].name_vpass
      #log.info room.dueling_players, pos
      room.scores[room.winner_name] = room.scores[room.winner_name] + 1
      if room.match_kill
        room.match_kill = false
        room.scores[room.winner_name] = 99

  if msg_name == 'MATCH_KILL' and client.pos == 0
    room.match_kill = true

  #lp跟踪
  if msg_name == 'DAMAGE' and client.pos == 0
    pos = buffer.readUInt8(1)
    pos = 1 - pos unless client.is_first
    pos = pos * 2 if pos >= 0 and room.hostinfo.mode == 2
    val = buffer.readInt32LE(2)
    room.dueling_players[pos].lp -= val
    room.dueling_players[pos].lp = 0 if room.dueling_players[pos].lp < 0
    if 0 < room.dueling_players[pos].lp <= 100
      ygopro.stoc_send_chat_to_room(room, "${lp_low_opponent}", ygopro.constants.COLORS.PINK)

  if msg_name == 'RECOVER' and client.pos == 0
    pos = buffer.readUInt8(1)
    pos = 1 - pos unless client.is_first
    pos = pos * 2 if pos >= 0 and room.hostinfo.mode == 2
    val = buffer.readInt32LE(2)
    room.dueling_players[pos].lp += val

  if msg_name == 'LPUPDATE' and client.pos == 0
    pos = buffer.readUInt8(1)
    pos = 1 - pos unless client.is_first
    pos = pos * 2 if pos >= 0 and room.hostinfo.mode == 2
    val = buffer.readInt32LE(2)
    room.dueling_players[pos].lp = val

  if msg_name == 'PAY_LPCOST' and client.pos == 0
    pos = buffer.readUInt8(1)
    pos = 1 - pos unless client.is_first
    pos = pos * 2 if pos >= 0 and room.hostinfo.mode == 2
    val = buffer.readInt32LE(2)
    room.dueling_players[pos].lp -= val
    room.dueling_players[pos].lp = 0 if room.dueling_players[pos].lp < 0
    if 0 < room.dueling_players[pos].lp <= 100
      ygopro.stoc_send_chat_to_room(room, "${lp_low_self}", ygopro.constants.COLORS.PINK)

  return false

#房间管理
ygopro.ctos_follow 'HS_TOOBSERVER', true, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  if room.hostinfo.no_watch
    ygopro.stoc_send_chat(client, "${watch_denied_room}", ygopro.constants.COLORS.RED)
    return true
  return false

ygopro.ctos_follow 'HS_KICK', true, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  for player in room.players
    if player and player.pos == info.pos and player != client
      ygopro.stoc_send_chat_to_room(room, "#{player.name} ${kicked_by_player}", ygopro.constants.COLORS.RED)
      if client.is_host and room.duel_stage == ygopro.constants.DUEL_STAGE.BEGIN and player.server
        # YGOPro closes the target socket after handling HS_KICK; this is not a room server failure.
        player.server.system_kicked = true
  return false

ygopro.stoc_follow 'TYPE_CHANGE', true, (buffer, info, client, server, datas)->
  selftype = info.type & 0xf
  is_host = ((info.type >> 4) & 0xf) != 0
  client.is_host = is_host
  client.pos = selftype
  #log.info "TYPE_CHANGE to #{client.name}:", info, selftype, is_host
  return false

ygopro.stoc_follow 'DUEL_START', false, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  if room.duel_stage == ygopro.constants.DUEL_STAGE.BEGIN #first start
    room.duel_stage = ygopro.constants.DUEL_STAGE.FINGER
    room.turn = 0
    room.dueling_players = []
    for player in room.players when player.pos != 7
      room.dueling_players[player.pos] = player
      room.scores[player.name_vpass] = 0
  else if room.duel_stage == ygopro.constants.DUEL_STAGE.SIDING and client.pos < 4 # side deck verified
    if client.side_tcount
      clearInterval client.side_interval
      client.side_interval = null
      client.side_tcount = null
  return

ygopro.ctos_follow 'SURRENDER', true, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  if room.duel_stage == ygopro.constants.DUEL_STAGE.BEGIN
    return true
  return false

ygopro.ctos_follow 'UPDATE_DECK', true, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return false unless room
  #log.info info
  if info.mainc > 256 or info.sidec > 256 # Prevent attack, see https://github.com/Fluorohydride/ygopro/issues/2174
    CLIENT_kick(client)
    return true
  return false

ygopro.stoc_follow 'SELECT_HAND', false, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  if client.pos == 0
    room.duel_stage = ygopro.constants.DUEL_STAGE.FINGER
  return

ygopro.stoc_follow 'SELECT_TP', false, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  room.duel_stage = ygopro.constants.DUEL_STAGE.FIRSTGO
  return

ygopro.stoc_follow 'CHANGE_SIDE', false, (buffer, info, client, server, datas)->
  room=ROOM_all[client.rid]
  return unless room
  if client.pos == 0
    room.duel_stage = ygopro.constants.DUEL_STAGE.SIDING
  return

#http
if settings.modules.http

  addCallback = (callback, text)->
    if not callback then return text
    return callback + "( " + text + " );"

  requestListener = (request, response)->
    parseQueryString = true
    u = url.parse(request.url, parseQueryString)

    if u.pathname == '/api/getrooms'
      pass_validated = authenticate(u.query.username, u.query.pass)
      if !settings.modules.http.public_roomlist and !pass_validated
        response.writeHead(200)
        response.end(addCallback(u.query.callback, '{"rooms":[{"roomid":"0","roomname":"密码错误","needpass":"true"}]}'))
      else
        roomsjson = [];
        for room in ROOM_all when room and room.established
          roomsjson.push({
            roomid: room.process_pid.toString(),
            roomname: if pass_validated then room.name else room.name.split('$', 2)[0],
            roommode: room.hostinfo.mode,
            needpass: (room.name.indexOf('$') != -1).toString(),
            users: _.sortBy((for player in room.players when player.pos?
              id: (-1).toString(),
              name: player.name,
              ip: if settings.modules.http.show_ip and pass_validated and !player.is_local then player.ip.slice(7) else null,
              status: if settings.modules.http.show_info and room.duel_stage != ygopro.constants.DUEL_STAGE.BEGIN and player.pos != 7 then (
                score: room.scores[player.name_vpass],
                lp: if player.lp? then player.lp else room.hostinfo.start_lp
              ) else null,
              pos: player.pos
            ), "pos"),
            istart: if room.duel_stage != ygopro.constants.DUEL_STAGE.BEGIN then (if settings.modules.http.show_info then ("Duel:" + room.duel_count + " " + (if room.duel_stage == ygopro.constants.DUEL_STAGE.SIDING then "Siding" else "Turn:" + (if room.turn? then room.turn else 0))) else 'start') else 'wait'
          })
        response.writeHead(200)
        response.end(addCallback(u.query.callback, JSON.stringify({rooms: roomsjson})))

    else if u.pathname == '/api/getscores'
      if u.query.limit? and (!_.isString(u.query.limit) or !/^\d+$/.test(u.query.limit))
        response.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'})
        response.end(JSON.stringify({error: 'limit must be a non-negative integer'}))
        return
      score_type = u.query.type or 'private'
      if score_type != 'private'
        response.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'})
        response.end(JSON.stringify({error: 'type must be private'}))
        return
      if !authenticate(u.query.username, u.query.pass)
        response.writeHead(403, {'Content-Type': 'application/json; charset=utf-8'})
        response.end(JSON.stringify({error: 'unauthorized'}))
        return
      limit = if u.query.limit? then parseInt(u.query.limit, 10) else null
      scores = for score_pair in ROOM_get_scores(ROOM_private_players_scores, limit)
        score = score_pair[1]
        total = score.win + score.lose
        {
          name: score_pair[0].split('$', 2)[0]
          win: score.win
          lose: score.lose
          flee: score.flee
          combo: score.combo
          total: total
          winRate: if total then Math.ceil(score.win / total * 100) else 0
          fleeRate: if total then Math.ceil(score.flee / total * 100) else 0
        }
      content_type = if u.query.callback then 'application/javascript; charset=utf-8' else 'application/json; charset=utf-8'
      response.writeHead(200, {'Content-Type': content_type})
      response.end(addCallback(u.query.callback, JSON.stringify({type: score_type, scores: scores})))

    else if u.pathname == '/api/message'
      if u.query.shout
        if !authenticate(u.query.username, u.query.pass)
          response.writeHead(200)
          response.end(addCallback(u.query.callback, "['密码错误', 0]"))
          return
        for room in ROOM_all when room and room.established
          ygopro.stoc_send_chat_to_room(room, u.query.shout, ygopro.constants.COLORS.YELLOW)
        response.writeHead(200)
        response.end(addCallback(u.query.callback, "['shout ok', '" + u.query.shout + "']"))

      else if u.query.stop
        if !authenticate(u.query.username, u.query.pass)
          response.writeHead(200)
          response.end(addCallback(u.query.callback, "['密码错误', 0]"))
          return
        if u.query.stop == 'false'
          u.query.stop = false
        response.writeHead(200)
        try
          setting_change(settings, 'modules:stop', u.query.stop)
          response.end(addCallback(u.query.callback, "['stop ok', '" + u.query.stop + "']"))
        catch err
          response.end(addCallback(u.query.callback, "['stop fail', '" + u.query.stop + "']"))

      else if u.query.kick
        if !authenticate(u.query.username, u.query.pass)
          response.writeHead(200)
          response.end(addCallback(u.query.callback, "['密码错误', 0]"))
          return
        ROOM_kick(u.query.kick, (err, found)->
          response.writeHead(200)
          if err
            response.end(addCallback(u.query.callback, "['kick fail', '" + u.query.kick + "']"))
          else if found
            response.end(addCallback(u.query.callback, "['kick ok', '" + u.query.kick + "']"))
          else
            response.end(addCallback(u.query.callback, "['room not found', '" + u.query.kick + "']"))
        )

      else if u.query.reboot
        if !authenticate(u.query.username, u.query.pass)
          response.writeHead(200)
          response.end(addCallback(u.query.callback, "['密码错误', 0]"))
          return
        ROOM_kick("all", (err, found)->
          response.writeHead(200)
          response.end(addCallback(u.query.callback, "['reboot ok', '" + u.query.reboot + "']"))
          process.exit()
        )

      else
        response.writeHead(400)
        response.end()

    else
      response.writeHead(400)
      response.end()
    return

  http_server = http.createServer(requestListener)
  http_server.listen settings.modules.http.port

  if settings.modules.http.ssl.enabled
    https = require 'https'
    options =
      cert: fs.readFileSync(settings.modules.http.ssl.cert)
      key: fs.readFileSync(settings.modules.http.ssl.key)
    https_server = https.createServer(options, requestListener)
    https_server.listen settings.modules.http.ssl.port
