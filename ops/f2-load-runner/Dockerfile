# F2-DRAFT-03: isolated plan runner using the approved backend importer.
# Build has no SQL/network access to production; deploy remains inert.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "-e", "console.log('F2_DRAFT_RUNNER_INERT')"]
