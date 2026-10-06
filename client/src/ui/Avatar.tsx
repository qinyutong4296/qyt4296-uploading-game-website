export function isImageAvatar(avatar?: string | null) {
  const v = String(avatar || "").trim();
  return v.startsWith("/avatars/") || v.startsWith("blob:") || v.startsWith("data:image/");
}

export function AvatarFace({
  avatar,
  name,
  className
}: {
  avatar?: string | null;
  name?: string;
  className?: string;
}) {
  const fallback = (name || "玩").slice(0, 1);
  if (isImageAvatar(avatar)) {
    return <img src={avatar!} alt="" className={className} />;
  }
  return <span className={className}>{avatar || fallback}</span>;
}
