import React from "react";

/** Kare-style 16×16 pixel icons; `shapeRendering` keeps edges crisp when scaled. */
const px = { shapeRendering: "crispEdges" as const };

function rects(coords: string, fill = "currentColor"): React.ReactNode {
  return coords.split(/\s+/).map((pair, i) => {
    const [xs, ys] = pair.split(",").map(Number);
    return <rect key={i} x={xs} y={ys} width={1} height={1} fill={fill} />;
  });
}

/** Susan Kare–style pointing finger (8×8 scaled). */
export function JoshuFingerMark({ className }: { className?: string }) {
  const c =
    "3,0 4,0 3,1 4,1 5,1 3,2 4,2 5,2 3,3 4,3 5,3 3,4 4,4 2,5 3,5 4,5 1,6 2,6 3,6 0,7 1,7 2,7";
  return (
    <svg className={className} width={22} height={22} viewBox="0 0 8 8" aria-hidden {...px}>
      {rects(c)}
    </svg>
  );
}
