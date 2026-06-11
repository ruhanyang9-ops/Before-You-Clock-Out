module.exports = {
  apps: [
    {
      name: "afterwork-five-minutes",
      script: "server.js",
      cwd: "/opt/afterwork-five-minutes",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      out_file: "/opt/afterwork-five-minutes/logs/pm2-out.log",
      error_file: "/opt/afterwork-five-minutes/logs/pm2-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4173",
        DATA_DIR: "/opt/afterwork-five-minutes/data",
        COOKIE_SECURE: "true"
      },
      env_production: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4173",
        DATA_DIR: "/opt/afterwork-five-minutes/data",
        COOKIE_SECURE: "true"
      }
    }
  ]
};
