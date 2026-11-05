import { handleRequest } from "@orcus/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export const GET = (request: Request) => handleRequest(request);
export const POST = (request: Request) => handleRequest(request);
export const PATCH = (request: Request) => handleRequest(request);
export const DELETE = (request: Request) => handleRequest(request);
