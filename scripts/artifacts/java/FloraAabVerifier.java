import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.security.interfaces.*;
import java.util.*;
import java.util.jar.*;
import java.util.zip.*;

// Trusted local helper: verifies JAR signatures, never loads classes or extracts entries.
// This is NOT bundletool validation, Play acceptance, APK signing or device installation.
class FloraAabVerifier {
  static final long MAX_TOTAL = 4L * 1024 * 1024 * 1024;
  static final long MAX_ENTRY = 1024L * 1024 * 1024;
  static final long MAX_META = 8L * 1024 * 1024;
  static final int MAX_ENTRIES = 50000;
  static class Rejected extends Exception { final String code; Rejected(String c) { code = c; } }
  static void reject(String code) throws Rejected { throw new Rejected("ARTIFACT_SIGNATURE_" + code); }
  static boolean signingMetadata(String n) {
    return n.equals("META-INF/MANIFEST.MF") || n.matches("META-INF/[A-Z0-9_-]{1,8}\\.(SF|RSA|DSA|EC)");
  }
  static void inspectLayout(Path path) throws Exception {
    Set<String> names = new HashSet<>(), sf = new HashSet<>(), blocks = new HashSet<>(); long size = 0; int count = 0; boolean config = false, manifest = false;
    try (ZipFile zip = new ZipFile(path.toFile())) {
      var all = zip.entries();
      while (all.hasMoreElements()) {
        ZipEntry e = all.nextElement(); String n = e.getName();
        if (++count > MAX_ENTRIES || e.getSize() > MAX_ENTRY || (n.startsWith("META-INF/") && e.getSize() > MAX_META)) reject("LIMIT");
        if (n.isEmpty() || n.length() > 1024 || n.startsWith("/") || n.indexOf('\\') >= 0 || n.indexOf(':') >= 0 || n.chars().anyMatch(c -> c < 32 || c == 127) || !names.add(n)) reject("LAYOUT_INVALID");
        String components = e.isDirectory() ? n.substring(0, n.length()-1) : n;
        for (String part : components.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) reject("LAYOUT_INVALID");
        if (e.getSize() < 0 || (e.getMethod() != ZipEntry.STORED && e.getMethod() != ZipEntry.DEFLATED) || (e.isDirectory() && e.getSize() != 0)) reject("LAYOUT_INVALID");
        String upper = n.toUpperCase(Locale.ROOT);
        if (signingMetadata(upper) && !n.equals(upper)) reject("LAYOUT_INVALID");
        if (n.matches("META-INF/[A-Z0-9_-]{1,8}\\.SF")) sf.add(n.substring(9, n.lastIndexOf('.')));
        if (n.matches("META-INF/[A-Z0-9_-]{1,8}\\.(RSA|DSA|EC)")) {
          String base = n.substring(9, n.lastIndexOf('.')); if (!blocks.add(base)) reject("LAYOUT_INVALID");
        }
        size += e.getSize(); if (size > MAX_TOTAL) reject("LIMIT");
        config |= n.equals("BundleConfig.pb") && e.getSize() > 0;
        manifest |= n.equals("base/manifest/AndroidManifest.xml") && e.getSize() > 0;
      }
    }
    if (!config || !manifest) reject("LAYOUT_INVALID");
    if ((!sf.isEmpty() || !blocks.isEmpty()) && (sf.size() != 1 || !sf.equals(blocks))) reject("LAYOUT_INVALID");
  }
  static X509Certificate certificate(CodeSigner[] signers, byte[] expected) throws Exception {
    if (signers == null || signers.length == 0) reject("UNSIGNED");
    if (signers.length != 1) reject("SIGNER_MISMATCH");
    var certificates = signers[0].getSignerCertPath().getCertificates();
    if (certificates.isEmpty() || !(certificates.get(0) instanceof X509Certificate)) reject("CERTIFICATE_INVALID");
    X509Certificate cert = (X509Certificate)certificates.get(0);
    if (!MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()), expected)) reject("SIGNER_MISMATCH");
    try { cert.checkValidity(); } catch (CertificateException error) { reject("CERTIFICATE_INVALID"); }
    boolean[] usage = cert.getKeyUsage(); var eku = cert.getExtendedKeyUsage();
    if ((usage != null && (usage.length == 0 || !usage[0])) || (eku != null && !eku.contains("1.3.6.1.5.5.7.3.3") && !eku.contains("2.5.29.37.0"))) reject("CERTIFICATE_INVALID");
    PublicKey key = cert.getPublicKey();
    boolean strong = key instanceof RSAKey && ((RSAKey)key).getModulus().bitLength() >= 2048
      || key instanceof ECKey && ((ECKey)key).getParams().getOrder().bitLength() >= 256
      || key instanceof DSAKey && ((DSAKey)key).getParams().getP().bitLength() >= 2048;
    if (!strong) reject("CERTIFICATE_INVALID");
    return cert;
  }
  public static void main(String[] args) {
    try {
      if (args.length != 2 || !args[1].matches("[a-f0-9]{64}")) reject("POLICY_INVALID");
      Path path = Path.of(args[0]); inspectLayout(path);
      byte[] expected = HexFormat.of().parseHex(args[1]), buffer = new byte[65536];
      long expanded = 0; int entries = 0; X509Certificate cert = null;
      try (JarFile jar = new JarFile(path.toFile(), true)) {
        if (jar.getManifest() == null) reject("UNSIGNED");
        // JarFile verifies entries that remain. Reject removal of signed entries too.
        for (String name : jar.getManifest().getEntries().keySet()) {
          JarEntry entry = jar.getJarEntry(name);
          if (entry == null || entry.isDirectory()) reject("LAYOUT_INVALID");
        }
        var all = jar.entries();
        while (all.hasMoreElements()) {
          JarEntry entry = all.nextElement(); if (entry.isDirectory()) continue;
          long size = 0;
          try (InputStream stream = jar.getInputStream(entry)) {
            for (int n; (n = stream.read(buffer)) != -1;) { size += n; expanded += n; if (size > MAX_ENTRY || expanded > MAX_TOTAL) reject("LIMIT"); }
          }
          if (size != entry.getSize()) reject("INVALID");
          if (signingMetadata(entry.getName())) continue;
          cert = certificate(entry.getCodeSigners(), expected); entries++;
        }
      }
      if (cert == null || entries < 2) reject("UNSIGNED");
      System.out.println("{\"signerSha256\":\"" + args[1] + "\",\"signedEntries\":" + entries
        + ",\"certificateNotBefore\":" + cert.getNotBefore().getTime() + ",\"certificateNotAfter\":" + cert.getNotAfter().getTime()
        + ",\"javaFeature\":" + Runtime.version().feature() + "}");
    } catch (Rejected error) { System.err.println(error.code); System.exit(1); }
      catch (Throwable error) { System.err.println("ARTIFACT_SIGNATURE_INVALID"); System.exit(1); }
  }
}
