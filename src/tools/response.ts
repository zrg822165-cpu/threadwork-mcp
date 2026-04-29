import { TeamMcpError } from "../errors.js";

export interface JsonToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function runTool<T>(fn: () => Promise<T> | T): Promise<JsonToolResponse> {
  try {
    return jsonResponse({ ok: true, result: await fn() });
  } catch (error) {
    return errorResponse(error);
  }
}

export function jsonResponse(value: unknown): JsonToolResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function errorResponse(error: unknown): JsonToolResponse {
  if (error instanceof TeamMcpError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                details: error.details
              }
            },
            null,
            2
          )
        }
      ]
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: "INTERNAL",
              message: error instanceof Error ? error.message : String(error)
            }
          },
          null,
          2
        )
      }
    ]
  };
}
