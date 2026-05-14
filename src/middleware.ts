import { NextRequest, NextResponse } from "next/server";

import { DEMO_AUTH_COOKIE, demoAuthToken } from "@/lib/demo-auth";

/**
 * Optional shared-password gate for the public demo.
 *
 * When NEXT_PUBLIC_DEMO_MODE=true and DEMO_PASSWORD is set in the Vercel
 * dashboard, visitors must POST the password to /api/demo-auth once to
 * receive an httpOnly cookie before they can load pages or call APIs.
 *
 * Leave DEMO_PASSWORD unset for a fully open demo.
 */
export async function middleware(req: NextRequest) {
  const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const demoPassword = process.env.DEMO_PASSWORD;

  if (!isDemo || !demoPassword) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname === "/demo-login" ||
    pathname === "/api/demo-auth" ||
    pathname === "/api/reset-demo"
  ) {
    return NextResponse.next();
  }

  const expected = await demoAuthToken(demoPassword);
  const token = req.cookies.get(DEMO_AUTH_COOKIE)?.value;
  if (token === expected) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const login = new URL("/demo-login", req.url);
  if (pathname !== "/") {
    login.searchParams.set("next", pathname);
  }
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
