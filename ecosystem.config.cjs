module.exports = {
  apps: [
    {
      name: 'volcengine-doubao-asr2-openai-proxy',
      cwd: __dirname,
      script: 'src/server.js',
      node_args: '--env-file=.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
