export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ErrorResponse {
  error?: { code?: string; message?: string; requestId?: string };
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const candidate = body as ErrorResponse;
    throw new ApiClientError(
      response.status,
      candidate.error?.code ?? 'UNKNOWN_ERROR',
      candidate.error?.message ?? 'Request failed',
      candidate.error?.requestId,
    );
  }
  return body as T;
}
