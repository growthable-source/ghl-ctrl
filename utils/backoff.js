// utils/backoff.js
async function exponentialBackoff(fn, maxAttempts = 3, baseDelay = 500) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
module.exports = { exponentialBackoff };
