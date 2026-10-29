import express from "express";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || process.env.MAS_API_URL;
const MAS_HMAC_KEY = process.env.MAS_HMAC_KEY;

function requireConfig() {
  if (!APPS_SCRIPT_URL) {
    throw new Error("APPS_SCRIPT_URL is not configured");
  }
  if (!MAS_HMAC_KEY) {
    throw new Error("MAS_HMAC_KEY is not configured");
  }
}

function signRequest(timestamp, requestId, payload) {
  const message = `${timestamp}\n${requestId}\n${payload}`;

  return crypto
    .createHmac("sha256", MAS_HMAC_KEY)
    .update(message, "utf8")
.digest("base64")
.replace(/\+/g, "-")
.replace(/\//g, "_");
}

async function callMasApi(command) {
  requireConfig();

  const timestamp = Date.now();
  const requestId = randomUUID();
  const payload = JSON.stringify(command);
  const signature = signRequest(timestamp, requestId, payload);

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      timestamp,
      requestId,
      payload,
      signature
    }),
    redirect: "follow"
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned invalid JSON: ${text.slice(0, 300)}`);
  }

  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.code || `HTTP ${response.status}`);
  }

  return data;
}

function createServer() {
  const server = new McpServer({
    name: "mas-order-mcp",
    version: "1.0.0"
  });

  server.tool(
    "register_mas_order",
    "군납 MAS 예상 주문을 Google Sheet에 등록합니다. 사용자가 명확하게 등록을 요청했을 때만 호출합니다.",
    {
      업체명: z.string().describe("거래처/업체명"),
      부대명: z.string().describe("납품 부대명"),
      품목: z.string().describe("사용자가 말한 품목명"),
      물류납품일: z.string().describe("YYYY-MM-DD 형식"),
      부대납품일: z.string().describe("YYYY-MM-DD 형식"),
      수량: z.number().positive().describe("납품 수량")
    },
    async (order) => {
      try {
        const result = await callMasApi({
          action: "create_expected",
          order
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `주문 등록 실패: ${error.message}`
            }
          ]
        };
      }
    }
  );

  server.tool(
    "mas_api_status",
    "MAS 주문 API의 연결 상태를 확인합니다.",
    {},
    async () => {
      try {
        const result = await callMasApi({
          action: "status"
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `상태 확인 실패: ${error.message}`
            }
          ]
        };
      }
    }
  );

  return server;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "MAS Order MCP",
    mcp: "/mcp"
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MAS Order MCP listening on port ${PORT}`);
});
