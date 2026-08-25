# Zero dependencies, so this is a copy. The only network access at runtime is to
# the pages you told it to watch.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY fixtures ./fixtures
ENV TRACKANYTHING_DIR=/data
VOLUME /data
ENTRYPOINT ["node", "/app/bin/trackanything.mjs"]
