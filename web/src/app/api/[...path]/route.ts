import { handleRequest } from "@orcus/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export const GET = handleRequest;
export const POST = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
