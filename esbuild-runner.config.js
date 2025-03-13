module.exports = {
  target: "node16",
  format: "cjs",
  external: ["uWebSockets.js", "ws"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development")
  }
};