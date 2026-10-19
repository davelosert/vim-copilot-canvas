/** Authenticated transport; injecting fetch keeps browser globals at composition. */
export function createApiClient({ token, fetch: request, baseUrl = "/api/" }) {
    const api = async (path, input) => {
        const response = await request(`${baseUrl}${path}`, {
            method: input === undefined ? "GET" : "POST",
            headers: { "X-Editor-Token": token, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
            ...(input === undefined ? {} : { body: JSON.stringify(input), keepalive: false }),
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.message), { code: result.error });
        return result;
    };
    for (const operation of ["draft", "save", "open", "reload"]) api[operation] = (input) => api(operation, input);
    api.document = (path) => api(path ? `document?path=${encodeURIComponent(path)}` : "document");
    return api;
}
