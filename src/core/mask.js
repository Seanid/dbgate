// 脱敏（§8.4）：phone / email / full / none。NULL 保持 NULL。
export function maskValue(rule, value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  switch (rule) {
    case 'phone': {
      // 138****8888：保留前 3 后 4；过短的退化为全打码
      if (s.length >= 7) return `${s.slice(0, 3)}****${s.slice(-4)}`;
      return '****';
    }
    case 'email': {
      const idx = s.indexOf('@');
      if (idx <= 0) return `***${s.slice(Math.max(0, s.length - 4))}`;
      const local = s.slice(0, idx);
      const domain = s.slice(idx); // 含 @
      return `${local.slice(0, 1)}***${domain}`;
    }
    case 'full':
      return '******';
    case 'none':
      return value; // 明文，需显式声明
    default:
      return value;
  }
}
