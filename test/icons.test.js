const { suite } = require('./support/harness')

/**
 * Model marks: a picture, or the letter — never a broken one.
 *
 * Xiaomi's site answers `/favicon.ico` with its home page and a 200, and the
 * fetcher took the page for the icon it had asked for: nine kilobytes of HTML
 * stored as `image/x-icon`, drawn as a broken picture beside every MiMo model
 * in the list and at the top of a side by side. The bytes now decide — and
 * all of them, not a signature at the front: a cached mark is never fetched
 * again, so a truncated one would stop every other source being tried.
 */
suite('model icons — pictures, not pages', async ({ check, section, subject }) => {
  const { icons } = subject
  const bytes = (...values) => Buffer.from(values)
  const text = (value) => Buffer.from(value, 'utf8')
  const dataUrl = (mime, body) => `data:${mime};base64,${body.toString('base64')}`

  /*
   * The smallest whole file of each kind, built rather than pasted, so what
   * makes each one whole is visible. Checksums are not checked by the app and
   * are left as zeros.
   */
  const chunk = (type, data = Buffer.alloc(0)) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const png = Buffer.concat([
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('IDAT', Buffer.alloc(10)),
    chunk('IEND')
  ])

  const icoImage = Buffer.alloc(40)
  const icoHeader = Buffer.alloc(6 + 16)
  icoHeader.writeUInt16LE(1, 2) // an icon
  icoHeader.writeUInt16LE(1, 4) // one image
  icoHeader.writeUInt32LE(icoImage.length, 6 + 8) // its size
  icoHeader.writeUInt32LE(6 + 16, 6 + 12) // and where it starts
  const ico = Buffer.concat([icoHeader, icoImage])

  const gif = Buffer.concat([text('GIF89a'), Buffer.alloc(20), bytes(0x3b)])
  const jpeg = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(20), bytes(0xff, 0xd9)])

  const webpBody = Buffer.concat([text('WEBPVP8 '), Buffer.alloc(12)])
  const webpSize = Buffer.alloc(4)
  webpSize.writeUInt32LE(webpBody.length)
  const webp = Buffer.concat([text('RIFF'), webpSize, webpBody])

  const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>\n')

  section('the formats a favicon comes in, whole')
  check('PNG', icons.imageMime(png) === 'image/png')
  check('ICO', icons.imageMime(ico) === 'image/x-icon')
  check('GIF', icons.imageMime(gif) === 'image/gif')
  check('JPEG', icons.imageMime(jpeg) === 'image/jpeg')
  check('WebP', icons.imageMime(webp) === 'image/webp')
  check('SVG', icons.imageMime(svg) === 'image/svg+xml')
  check(
    'SVG behind an XML declaration and a comment',
    icons.imageMime(text('<?xml version="1.0"?>\n<!-- mark -->\n<svg></svg>')) === 'image/svg+xml'
  )
  check('SVG after a byte-order mark', icons.imageMime(text('﻿  <svg></svg>')) === 'image/svg+xml')
  check('an SVG root that closes itself', icons.imageMime(text('<svg xmlns="x"/>')) === 'image/svg+xml')
  check('a JPEG padded after its end', icons.imageMime(Buffer.concat([jpeg, Buffer.alloc(4)])) === 'image/jpeg')

  section('the same files, cut short')
  /*
   * Every length short of the whole, for each format. A response that stopped
   * anywhere is not a picture, however much of one arrived first — the review
   * that asked for this found PNG accepted on four bytes and SVG on `<svg`.
   */
  for (const [name, whole, trailingSlack] of [
    ['PNG', png, 0],
    ['ICO', ico, 0],
    ['GIF', gif, 0],
    ['JPEG', jpeg, 0],
    ['WebP', webp, 0],
    // Its last byte is a newline, and a document without it is still whole.
    ['SVG', svg, 1]
  ]) {
    const accepted = []
    let threw = null
    for (let cut = 0; cut < whole.length - trailingSlack; cut++) {
      try {
        if (icons.imageMime(whole.subarray(0, cut))) accepted.push(cut)
      } catch (err) {
        threw = err.message
      }
    }
    check(`no truncated ${name} is taken for one`, accepted.length === 0, accepted)
    check(`and none of them throws`, threw === null, threw)
  }
  check(
    'an icon whose directory points past its end is refused',
    (() => {
      const lying = Buffer.from(ico)
      lying.writeUInt32LE(icoImage.length + 1, 6 + 8)
      return icons.imageMime(lying) === null
    })()
  )
  check(
    'so is a WebP shorter than it says it is',
    (() => {
      const lying = Buffer.from(webp)
      lying.writeUInt32LE(webpBody.length + 10, 4)
      return icons.imageMime(lying) === null
    })()
  )

  section('what a site sends instead')
  check('an HTML page is not a picture', icons.imageMime(text('<!doctype html>\n<html lang="en">')) === null)
  check(
    'nor is one that mentions an svg somewhere in it',
    icons.imageMime(text('<!DOCTYPE html><html><body><svg></svg></body></html>')) === null
  )
  check('nor is JSON', icons.imageMime(text('{"error":"not found"}')) === null)
  check('nor is nothing', icons.imageMime(Buffer.alloc(0)) === null)

  section('a cache written before the bytes were checked')
  check(
    'a page stored as an icon is not used',
    icons.isUsableIcon(dataUrl('image/x-icon', text('<!doctype html>\n<html lang="zh">'))) === false
  )
  check('a truncated mark stored as one is not used either', icons.isUsableIcon(dataUrl('image/png', png.subarray(0, 20))) === false)
  check('a real icon still is', icons.isUsableIcon(dataUrl('image/x-icon', ico)) === true)
  check('and so is a real mark that was labelled wrongly', icons.isUsableIcon(dataUrl('image/x-icon', png)) === true)
  check('something that is not a data URL is not used', icons.isUsableIcon('https://example.com/i.png') === false)
})
