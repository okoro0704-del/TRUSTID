type TrustStarsProps = {
  stars: number;
  maxStars?: number;
  label?: string;
  size?: "sm" | "md";
};

/** Filled stars = trust stage visible to Life OS (equals trust tier). */
export function TrustStars({
  stars,
  maxStars = 3,
  label,
  size = "sm",
}: TrustStarsProps) {
  const filled = Math.max(0, Math.min(maxStars, Math.floor(stars)));
  const aria =
    label ??
    `${filled} of ${maxStars} trust stars — same stage Life OS shows`;

  return (
    <span
      className={`trust-stars trust-stars-${size}`}
      role="img"
      aria-label={aria}
      title={aria}
    >
      {Array.from({ length: maxStars }, (_, i) => (
        <span
          key={i}
          className={i < filled ? "trust-star is-filled" : "trust-star"}
          aria-hidden="true"
        >
          ?
        </span>
      ))}
    </span>
  );
}
