# F2-DRAFT-10: isolated runner on PR #233 (262c57d1). Copy of the approved F2-DRAFT-05 runner.
# Database access is forbidden at build; startup remains inert.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "-e", "console.log('F2_DRAFT_RUNNER_INERT')"]
