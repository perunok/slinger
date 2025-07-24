export async function mockSendRequest(request) {
  // Simulate API response
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        status: 200,
        data: {
          message: `Mock response for ${request.method} ${request.url}`,
          headers: request.headers,
          body: request.body || null
        }
      });
    }, 500);
  });
}