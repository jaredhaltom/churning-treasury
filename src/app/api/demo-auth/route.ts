import { NextRequest, NextResponse } from "next/server";

import { IS_DEMO } from "@/lib/demo";
import { DEMO_AUTH_COOKIE, demoAuthToken } from "@/lib/demo-auth";

export async function POST(req: NextRequest) {
  if (!IS_DEMO) {
    return NextResponse.json({ error: "Not in demo mode" }, { status: 404 });
  }

  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword) {
    return NextResponse.json({ error: "Password gate not configured" }, { status: 404 });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.password !== demoPassword) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(DEMO_AUTH_COOKIE, demoAuthToken(demoPassword), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return res;
}
