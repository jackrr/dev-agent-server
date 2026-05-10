# Tiny CONNECT-only egress proxy.
# tinyproxy supports an upstream allowlist via the `Filter` directive.
# At container start, we merge /etc/proxy/allowlist.txt (server defaults) with
# /etc/proxy/project.txt (mounted from the target repo, if present) into the
# tinyproxy filter file.
FROM alpine:3.20

RUN apk add --no-cache tinyproxy bash

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist.txt /etc/proxy/allowlist.txt
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8888
ENTRYPOINT ["/entrypoint.sh"]
