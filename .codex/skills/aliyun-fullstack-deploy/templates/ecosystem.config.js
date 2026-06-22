module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || "{{APP_NAME}}",
      cwd: process.env.APP_DIR || "{{APP_DIR}}",
      script: "npm",
      args: "run start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      out_file: "{{APP_DIR}}/logs/pm2-out.log",
      error_file: "{{APP_DIR}}/logs/pm2-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "{{PORT}}"
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || "{{PORT}}"
      }
    }
  ]
};
