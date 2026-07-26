// Thin fetch wrapper. Throws Error with server-provided message.
async function call(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Network error — check your connection');
  }
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    window.dispatchEvent(new CustomEvent('mr:unauthed'));
    throw new Error('Signed out');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body) => call('POST', url, body ?? {}),
  put: (url, body) => call('PUT', url, body ?? {}),
  del: (url) => call('DELETE', url),
};
