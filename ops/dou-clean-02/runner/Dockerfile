# Backup and isolated restore execute entirely inside Railway.
# trixie ships jq 1.7: bookworm's jq 1.6 exits 0 for `jq -e` on EMPTY input,
# which turned "no eligible candidate" into a vacuous pass in production.
FROM postgres:18-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ca-certificates util-linux curl \
 && rm -rf /var/lib/apt/lists/*
COPY ops/dou-clean-02 /opt/dou-clean-02
RUN chmod +x /opt/dou-clean-02/runner/backup-restore.sh \
    /opt/dou-clean-02/runner/postdeploy-smoke.sh
ENTRYPOINT []
CMD ["/opt/dou-clean-02/runner/backup-restore.sh"]
