# DOE-SP rebuild runner (Railway). Server major must match production (18).
FROM postgres:18-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY ops/doe-sp /opt/doe-sp
RUN chmod +x /opt/doe-sp/runner/*.sh
ENTRYPOINT []
CMD ["/opt/doe-sp/runner/prep.sh"]
