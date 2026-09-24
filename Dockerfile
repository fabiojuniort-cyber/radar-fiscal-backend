FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html 404.html style.css app-shell.css app.js auth.js portal.js portal-shell.js login.html registrar.html app.html server.js logo.webp favicon.ico favicon-32.png apple-touch-icon.png ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
