import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi"

const wide = (text: string) => Buffer.from(text + "\0", "utf16le")
const pointer = (buffer: Buffer): Pointer => {
  const value = Number(buffer.readBigUInt64LE())
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid Windows security pointer")
  return value as Pointer
}

/** Native DACL inspection; no shell, helper process, environment interpolation or localized command output. */
export function windowsPrivate(target: string, directory: boolean, secure: boolean, protectedRoot: boolean) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Unverified Windows security runtime")
  const p = FFIType.ptr
  const u = FFIType.u32
  const kernel = dlopen("kernel32.dll", {
    OpenProcess: { args: [u, u, u], returns: p },
    CloseHandle: { args: [p], returns: u },
    LocalFree: { args: [p], returns: p },
    lstrlenW: { args: [p], returns: FFIType.i32 },
  })
  const api = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [p, u, p], returns: u },
    GetTokenInformation: { args: [p, u, p, u, p], returns: u },
    ConvertSidToStringSidW: { args: [p, p], returns: u },
    GetNamedSecurityInfoW: { args: [p, u, u, p, p, p, p, p], returns: u },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: [p, u, u, p, p], returns: u },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [p, u, p, p], returns: u },
    GetSecurityDescriptorDacl: { args: [p, p, p, p], returns: u },
    SetNamedSecurityInfoW: { args: [p, u, u, p, p, p, p], returns: u },
  })
  const ok = (result: number) => { if (!result) throw new Error("Windows security operation failed") }
  const text = (value: Pointer) => Buffer.from(toArrayBuffer(value, 0, kernel.symbols.lstrlenW(value) * 2)).toString("utf16le")
  const sid = (value: Pointer) => {
    const output = Buffer.alloc(8)
    ok(api.symbols.ConvertSidToStringSidW(value, ptr(output)))
    const allocated = pointer(output)
    try { return text(allocated) } finally { kernel.symbols.LocalFree(allocated) }
  }
  const currentSID = () => {
    const processHandle = kernel.symbols.OpenProcess(0x1000, 0, process.pid)
    if (!processHandle) throw new Error("Cannot inspect Windows process identity")
    const token = Buffer.alloc(8)
    try {
      ok(api.symbols.OpenProcessToken(processHandle, 8, ptr(token)))
      const tokenHandle = pointer(token)
      try {
        const size = Buffer.alloc(4)
        api.symbols.GetTokenInformation(tokenHandle, 1, null, 0, ptr(size))
        const length = size.readUInt32LE()
        if (length < 8 || length > 4096) throw new Error("Invalid Windows identity size")
        const user = Buffer.alloc(length)
        ok(api.symbols.GetTokenInformation(tokenHandle, 1, ptr(user), length, ptr(size)))
        return sid(pointer(user))
      } finally { kernel.symbols.CloseHandle(tokenHandle) }
    } finally { kernel.symbols.CloseHandle(processHandle) }
  }
  const read = (name: Buffer) => {
    const owner = Buffer.alloc(8)
    const output = Buffer.alloc(8)
    if (api.symbols.GetNamedSecurityInfoW(ptr(name), 1, 5, ptr(owner), null, null, null, ptr(output)) !== 0)
      throw new Error("Cannot inspect Windows file security")
    const descriptor = pointer(output)
    try {
      const encoded = Buffer.alloc(8)
      ok(api.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 5, ptr(encoded), null))
      const allocated = pointer(encoded)
      try { return { owner: sid(pointer(owner)), sddl: text(allocated) } }
      finally { kernel.symbols.LocalFree(allocated) }
    } finally { kernel.symbols.LocalFree(descriptor) }
  }
  try {
    const user = currentSID()
    const name = wide(target)
    const original = read(name)
    // Administrators can take ownership regardless of a user's DACL; other ordinary Windows users are excluded.
    if (original.owner !== user && original.owner !== "S-1-5-32-544") throw new Error("Native profile has a different owner")
    if (secure) {
      if (!directory) throw new Error("Only a new managed directory may be secured")
      const encoded = wide(`D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)`)
      const output = Buffer.alloc(8)
      ok(api.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(encoded), 1, ptr(output), null))
      const descriptor = pointer(output)
      try {
        const present = Buffer.alloc(4), dacl = Buffer.alloc(8), defaulted = Buffer.alloc(4)
        ok(api.symbols.GetSecurityDescriptorDacl(descriptor, ptr(present), ptr(dacl), ptr(defaulted)))
        if (!present.readUInt32LE() || api.symbols.SetNamedSecurityInfoW(ptr(name), 1, 0x80000004, null, null, pointer(dacl), null) !== 0)
          throw new Error("Cannot protect native profile directory")
      } finally { kernel.symbols.LocalFree(descriptor) }
    }
    const { sddl } = read(name)
    const dacl = sddl.slice(sddl.indexOf("D:"))
    const first = dacl.indexOf("(")
    const flags = dacl.slice(2, first)
    if (!dacl.startsWith("D:") || first < 2 || (protectedRoot && flags.replace(/AI|AR/g, "") !== "P"))
      throw new Error("Native profile security descriptor is not protected")
    const entries = [...dacl.slice(first).matchAll(/\(([^()]*)\)/g)]
    if (!entries.length || entries.map((entry) => entry[0]).join("") !== dacl.slice(first))
      throw new Error("Unsupported native profile permissions")
    const allowed = new Set([user, "SY", "S-1-5-18"])
    for (const entry of entries) {
      const fields = entry[1]!.split(";")
      if (fields.length !== 6 || fields[0] !== "A" || fields[2] !== "FA" || fields[3] || fields[4] || !allowed.has(fields[5]!))
        throw new Error("Native profile permissions allow another identity")
      if (directory && (!fields[1]!.includes("OI") || !fields[1]!.includes("CI") || fields[1]!.includes("IO")))
        throw new Error("Native profile permissions do not protect descendants")
    }
  } finally { api.close(); kernel.close() }
}
