# F2-DRAFT-05: isolated runner on the COORD-approved backend SHA.
# Database access is forbidden at build; startup remains inert.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "-e", "console.log('F2_DRAFT_RUNNER_INERT')"]
