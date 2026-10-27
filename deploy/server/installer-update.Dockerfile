# Use only after verifying that install.sh is the sole runtime change from
# this immutable, previously validated base. Other changes need the full build.
ARG BASE_IMAGE=docker.heyphp.com/lightmoni/lightmoni@sha256:51ebf2093ec5e604dc0a6e0f5b6a231caed9e85a2476edb05d37adb00cd72826
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.revision=${BUILD_REVISION} \
      org.opencontainers.image.base.name=${BASE_IMAGE}
COPY --chown=0:0 --chmod=644 deploy/agent/install.sh /opt/lightmoni/runtime/downloads/install.sh
