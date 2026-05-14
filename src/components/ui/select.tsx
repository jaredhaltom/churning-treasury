import * as React from "react";
import { cn } from "@/lib/utils";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Minimal styled native <select>. For more complex needs, swap in shadcn's
 * Radix-based Select later.
 *
 * Dark-mode note: `color-scheme: dark` on :root (globals.css) tells the
 * browser to render native form controls (including the <option> popup) in
 * dark chrome. Explicit style on the element below pins the closed-state
 * background so it matches our theme even if color-scheme is ignored.
 */
// Re-inject dark styles on <option> descendants (including those nested in
// <optgroup>). Safari in particular doesn't always apply parent styles to the
// open <option> list, so we force the theme-aware colors onto each node.
function styleOptionNode(child: React.ReactNode): React.ReactNode {
  if (!React.isValidElement(child)) return child;
  if (child.type === "option") {
    const el = child as React.ReactElement<React.OptionHTMLAttributes<HTMLOptionElement>>;
    return React.cloneElement(el, {
      style: {
        backgroundColor: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        ...(el.props.style ?? {}),
      },
    });
  }
  if (child.type === "optgroup") {
    const el = child as React.ReactElement<
      React.OptgroupHTMLAttributes<HTMLOptGroupElement>
    >;
    return React.cloneElement(
      el,
      {
        style: {
          backgroundColor: "hsl(var(--background))",
          color: "hsl(var(--muted-foreground))",
          ...(el.props.style ?? {}),
        },
      },
      React.Children.map(el.props.children, (c) => styleOptionNode(c)),
    );
  }
  return child;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, style, ...props }, ref) => (
    <select
      ref={ref}
      // colorScheme at the element level is a second safety net for the
      // option list on browsers that don't fully inherit from :root.
      style={{ colorScheme: "dark", ...style }}
      className={cn(
        "flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Chevron as inline SVG so it stays crisp on dark backgrounds.
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><polyline points=%226 9 12 15 18 9%22/></svg>')] bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-9",
        className,
      )}
      {...props}
    >
      {React.Children.map(children, (child) => styleOptionNode(child))}
    </select>
  ),
);
Select.displayName = "Select";

export { Select };
