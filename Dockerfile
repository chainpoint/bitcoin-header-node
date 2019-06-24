FROM node:alpine AS base

RUN mkdir /code
WORKDIR /code

# copy dependency information and package files
COPY package.json \
     yarn.lock \
     /code/

COPY bin /code/bin
COPY lib /code/lib

# intermediate image with dependencies needed for initial build
FROM base as build

# Install updates and dependencies needed to build the package
RUN apk upgrade --no-cache && \
    apk add --no-cache git python make g++ bash && \
    npm install -g -s --no-progress yarn

# Install package dependencies
RUN yarn install

# Copy built files, but don't include build deps
FROM base
ENV PATH="${PATH}:/code/bin:/code/node_modules/.bin"
COPY --from=build /code /code/

# start the header node. Can pass additional options with
# CMD in docker-compose or from command line with `docker run`
ENTRYPOINT ["bhn"]

# Main-net and Test-net
EXPOSE 8334 8333 8332 18334 18333 18332
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD [ "bcoin-cli info >/dev/null" ]
