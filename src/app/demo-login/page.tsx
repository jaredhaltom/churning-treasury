import { Suspense } from "react";
import DemoLoginForm from "./demo-login-form";

export default function DemoLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <DemoLoginForm />
    </Suspense>
  );
}
