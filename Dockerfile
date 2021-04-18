FROM node
RUN npm install -g bhn bval bcrypto

ENTRYPOINT ["bhn"]

# Main-net and Test-net
EXPOSE 8334 8333 8332 18334 18333 18332
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD [ "bcoin-cli info >/dev/null" ]
