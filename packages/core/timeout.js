export function timeoutError(message, code = "operation_timeout") {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
