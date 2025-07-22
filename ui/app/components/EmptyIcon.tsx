export default function EmptyIcon({
  size,
  ...svgProps
}: { size?: number | string } & React.ComponentPropsWithoutRef<"svg">) {
  return <svg {...svgProps} width={size} height={size}></svg>;
}
