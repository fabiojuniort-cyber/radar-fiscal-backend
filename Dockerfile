FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html style.css app.js auth.js login.html registrar.html app.html server.js logo.webp ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
