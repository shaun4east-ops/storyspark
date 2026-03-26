FROM node:18-alpine
WORKDIR /app
COPY package.json .
COPY server.js .
COPY app.html .
EXPOSE 3000
CMD ["node", "server.js"]
# v4-pulid-clean
