const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use('/fdapi', createProxyMiddleware({
    target: 'https://api.football-data.org',
    changeOrigin: true,
    pathRewrite: { '^/fdapi': '' },
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('X-Auth-Token', process.env.REACT_APP_FD_API_KEY);
      }
    }
  }));
};