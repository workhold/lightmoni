FROM node:24.15.0-bookworm-slim
COPY --from=m.daocloud.io/docker.io/library/docker:27.5.1-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=15 update && apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=15 install -y --no-install-recommends nginx openssl iproute2 systemd procps && rm -rf /var/lib/apt/lists/*
COPY --from=m.daocloud.io/docker.io/library/docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
RUN groupadd --system lightmoni-agent && useradd --system --gid lightmoni-agent --no-create-home --home-dir /var/lib/lightmoni-agent --shell /usr/sbin/nologin lightmoni-agent
COPY deploy/agent/deployment-permissions.mjs /opt/lightmoni-agent/current/deployment-permissions.mjs
COPY deploy/agent/launcher.sh /usr/local/bin/lightmoni-agent
COPY deploy/agent/lightmoni-agent.service /tmp/lightmoni-agent.service
RUN ln -s /usr/local/bin/node /opt/lightmoni-agent/current/node && chmod 0755 /usr/local/bin/lightmoni-agent && node /opt/lightmoni-agent/current/deployment-permissions.mjs prepare && install -d -m 0700 -o lightmoni-agent -g lightmoni-agent /etc/lightmoni-agent /var/lib/lightmoni-agent && printf '{}\n' > /etc/lightmoni-agent/config.json && chown lightmoni-agent:lightmoni-agent /etc/lightmoni-agent/config.json && chmod 0600 /etc/lightmoni-agent/config.json && systemd-analyze verify /tmp/lightmoni-agent.service
