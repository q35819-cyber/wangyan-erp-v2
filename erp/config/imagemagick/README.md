# ImageMagick server runtime

The ERP invokes ImageMagick 7.1.2-29 Q16-HDRI as an external server-side runtime. It is not bundled with the browser application and sellers do not install it. ImageMagick is Copyright 1999 ImageMagick Studio LLC. The accompanying `LICENSE.txt` is copied from the verified Windows 7.1.2-29 installation; the authoritative license is <https://imagemagick.org/license/>.

`policy.xml` is mandatory. It limits resources, disables delegates, filters, indirect reads and unsafe coders, blocks every installed coder module except JPEG, PNG, BMP, GIF, WebP and HEIC/AVIF, permits only JPEG/PNG output, and is validated together with the exact runtime version before image processing is enabled.
