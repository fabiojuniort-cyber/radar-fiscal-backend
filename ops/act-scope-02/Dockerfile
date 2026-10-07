FROM postgres:18-trixie
RUN apt-get update && apt-get install -y --no-install-recommends jq ca-certificates util-linux curl nodejs node-pg && rm -rf /var/lib/apt/lists/*
COPY ops/act-scope-02 /opt/act-scope-02
RUN chmod +x /opt/act-scope-02/backup-restore.sh
ENTRYPOINT []
CMD ["/opt/act-scope-02/backup-restore.sh"]
