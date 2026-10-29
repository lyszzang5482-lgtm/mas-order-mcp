import express from "express";
import crypto from "crypto";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL || process.env.MAS_API_URL;
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
    throw new Error(
      `Apps Script returned invalid JSON: ${text.slice(0, 300)}`
    );
  }

  if (!response.ok || data.success === false) {
    throw new Error(
      data.error || data.code || `HTTP ${response.status}`
    );
  }

  return data;
}

function createServer() {
  const server = new McpServer({
    name: "mas-order-mcp",
    version: "1.0.1"
  });

  server.tool(
    "register_mas_order",
    "군납 MAS 예상 주문을 등록합니다. 사용자가 명확하게 등록을 요청했을 때만 호출합니다. 샘플은 주문수량에 합산하지 않고 별도로 전달합니다.",
    {
      업체명: z.string().describe("거래처/업체명"),
      부대명: z.string().describe("납품 부대명"),
      품목: z.string().describe("사용자가 말한 품목명"),
      물류납품일: z.string().describe("YYYY-MM-DD 형식"),
      부대납품일: z.string().describe("YYYY-MM-DD 형식"),
      수량: z.number().int().positive().describe("샘플을 제외한 예상 주문수량"),
      샘플: z.number().int().min(0).optional()
        .describe("별도로 입력할 샘플수량. 사용자가 말하지 않으면 생략")
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

  server.tool(
    "search_expected_orders",
    "등록되어 있는 MAS 예상 주문을 검색합니다. 조회만 하며 주문을 등록하거나 변경하지 않습니다.",
    {
      업체명: z.string().describe("거래처/업체명"),
      부대명: z.string().optional().describe("납품 부대명"),
      품목: z.string().optional().describe("사용자가 말한 품목명"),
      물류납품일: z.string().optional().describe("YYYY-MM-DD 형식"),
      부대납품일: z.string().optional().describe("YYYY-MM-DD 형식"),
      수량: z.number().int().positive().optional().describe("납품 수량")
    },
    async (order) => {
      try {
        const result = await callMasApi({
          action: "search_expected",
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
              text: `예상 주문 검색 실패: ${error.message}`
            }
          ]
        };
      }
    }
  );

  server.tool(
    "confirm_expected_order",
    "기존 예상 주문을 확정으로 변경합니다. 사용자가 명확하게 확정 변경을 요청했을 때만 호출합니다. 푸드스페이스·푸르온·디엔비는 예상수량을 유지하고 확정수량에 입력하며, 나머지 업체는 기존 납품수량을 변경합니다. 샘플은 별도 전달합니다. 검색 결과가 여러 건이거나 없으면 임의 수정 또는 신규 등록하지 않습니다.",
    {
      업체명: z.string().describe("거래처/업체명"),
      부대명: z.string().describe("납품 부대명"),
      품목: z.string().describe("사용자가 말한 품목명"),
      물류납품일: z.string().describe("YYYY-MM-DD 형식"),
      부대납품일: z.string().describe("YYYY-MM-DD 형식"),
      수량: z.number().int().positive()
        .describe("샘플을 제외한 최종 확정수량"),
      샘플: z.number().int().min(0).optional()
        .describe("별도 샘플수량. 생략하면 기존 샘플 유지, 0이면 샘플을 0으로 변경")
    },
    async (order) => {
      try {
        const result = await callMasApi({
          action: "confirm_expected",
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
              text: `예상 주문 확정 변경 실패: ${error.message}`
            }
          ]
        };
      }
    }
  );

  server.tool(
    "update_confirmed_order",
    "이미 확정된 MAS 주문을 수정합니다. 사용자가 명확하게 기존 확정 주문의 수정을 요청했을 때만 호출합니다. 푸드스페이스·푸르온·디엔비는 예상수량을 유지하고 확정수량에 입력하며, 나머지 업체는 기존 납품수량을 변경합니다. 샘플은 별도 전달하고 생략 시 기존 값을 유지합니다. 대상이 여러 건이거나 없으면 임의 수정 또는 신규 등록하지 않습니다.",
    {
      업체명: z.string().describe("거래처/업체명"),
      부대명: z.string().describe("납품 부대명"),
      품목: z.string().describe("사용자가 말한 품목명"),
      물류납품일: z.string().describe("YYYY-MM-DD 형식"),
      부대납품일: z.string().describe("YYYY-MM-DD 형식"),
      수량: z.number().int().positive()
        .describe("샘플을 제외한 최종 확정수량"),
      샘플: z.number().int().min(0).optional()
        .describe("별도 샘플수량. 생략하면 기존 샘플 유지, 0이면 샘플을 0으로 변경")
    },
    async (order) => {
      try {
        const result = await callMasApi({
          action: "update_confirmed",
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
              text: `확정 주문 수정 실패: ${error.message}`
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
