FROM node:22-trixie-slim

RUN npm install --global pm2

RUN apt-get update && \
    env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libevent-dev \
        liblua5.4-dev \
        liblzma-dev \
        libsqlite3-dev \
        wget && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /srvpro

RUN git clone --branch=server --recursive --depth=1 https://github.com/mycard/ygopro.git

RUN cd ygopro && \
    wget -O premake5.tar.gz https://github.com/premake/premake-core/releases/download/v5.0.0-beta8/premake-5.0.0-beta8-linux.tar.gz && \
    echo "63edd3e7461eebdd45b500a3c7e8ad4e7a67d68f230010f9a97cbb71b4ec59c8  premake5.tar.gz" | sha256sum -c - && \
    tar xf premake5.tar.gz && \
    rm premake5.tar.gz && \
    chmod +x ./premake5 && \
    cp -r premake/* . && \
    cp -r resource/* . && \
    ./premake5 gmake --lua-deb && \
    make -C build config=release -j$(nproc) && \
    mv ./bin/release/ygopro . && \
    mkdir replay expansions && \
    rm -rf .git* bin obj build ocgcore cmake lua premake* sound textures .travis.yml *.txt appveyor.yml LICENSE README.md *.lua strings.conf system.conf && \
    ls gframe | sed '/config.h/d' | xargs -I {} rm -rf gframe/{} && \
    cd .. && \
    mkdir -p config replays pm2.logs

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 7911 7922

CMD ["pm2-runtime", "start", "pm2.json"]
