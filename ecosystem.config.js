module.exports = {
  apps: [
    {
      name: "browser-agent",
    node_args: '--max-old-space-size=256',
      script: "agent-server.js",
      autorestart: true,
      max_memory_restart: "100M",
      env: {
        NODE_ENV: "production",
        BROWSER_AGENT_PORT: 3102,
        LIBGL_ALWAYS_SOFTWARE: '1',
      },
    },
  ],
};
