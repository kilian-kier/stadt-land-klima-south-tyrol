FROM directus/directus:10@sha256:44c3242d5e3f46edbc07571e38d340d67dccdf95bc55fafd3abb0a2720b978a3
ARG UID=1000
ARG GID=1000

COPY build.sh /build.sh
COPY start_dev.sh /start_dev.sh
COPY start_prod.sh /start_prod.sh

RUN ln -s /directus/cli/index.mjs /directus/directus-cli

USER root
RUN apk add bash shadow

RUN groupmod -g "${GID}" node && usermod -u "${UID}" -g "${GID}" node

RUN \
  chown node:node /build.sh && \
  chown node:node /start_dev.sh && \
  chown node:node /start_prod.sh

USER node

CMD ["sh", "/start_prod.sh"]
