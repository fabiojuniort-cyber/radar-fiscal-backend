FROM node:24-alpine
WORKDIR /app
COPY index.html style.css app.js server.js logo.webp ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
