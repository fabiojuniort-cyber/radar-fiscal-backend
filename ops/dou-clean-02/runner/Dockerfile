# Backup and isolated restore execute entirely inside Railway.
FROM postgres:18-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
COPY ops/dou-clean-02 /opt/dou-clean-02
RUN chmod +x /opt/dou-clean-02/runner/backup-restore.sh
ENTRYPOINT []
CMD ["/opt/dou-clean-02/runner/backup-restore.sh"]
