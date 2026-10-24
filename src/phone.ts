// US/NANP only: area code and exchange must start with 2-9.
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) && !/^\+(?!1)/.test(raw.trim()) ? `+1${national}` : null;
}
