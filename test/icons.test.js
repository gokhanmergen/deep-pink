const { suite } = require('./support/harness')

/**
 * Model marks: a picture, or the letter — never a broken one.
 *
 * Xiaomi's site answers `/favicon.ico` with its home page and a 200, and the
 * fetcher took the page for the icon it had asked for: nine kilobytes of HTML
 * stored as `image/x-icon`, drawn as a broken picture beside every MiMo model
 * in the list and at the top of a side by side. The bytes now decide.
 */
suite('model icons — pictures, not pages', async ({ check, section, subject }) => {
  const { icons } = subject
  const bytes = (...values) => Buffer.from(values)
  const text = (value) => Buffer.from(value, 'utf8')
  const dataUrl = (mime, body) => `data:${mime};base64,${body.toString('base64')}`

  section('the formats a favicon comes in')
  check('PNG', icons.imageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) === 'image/png')
  check('ICO', icons.imageMime(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00)) === 'image/x-icon')
  check('GIF', icons.imageMime(text('GIF89a')) === 'image/gif')
  check('JPEG', icons.imageMime(bytes(0xff, 0xd8, 0xff, 0xe0)) === 'image/jpeg')
  check('WebP', icons.imageMime(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')) === 'image/webp')
  check('SVG', icons.imageMime(text('<svg xmlns="http://www.w3.org/2000/svg"/>')) === 'image/svg+xml')
  check(
    'SVG behind an XML declaration and a comment',
    icons.imageMime(text('<?xml version="1.0"?>\n<!-- mark -->\n<svg/>')) === 'image/svg+xml'
  )
  check('SVG after a byte-order mark', icons.imageMime(text('﻿  <svg/>')) === 'image/svg+xml')

  section('what a site sends instead')
  check('an HTML page is not a picture', icons.imageMime(text('<!doctype html>\n<html lang="en">')) === null)
  check(
    'nor is one that mentions an svg somewhere in it',
    icons.imageMime(text('<!DOCTYPE html><html><body><svg/></body></html>')) === null
  )
  check('nor is JSON', icons.imageMime(text('{"error":"not found"}')) === null)
  check('nor is nothing', icons.imageMime(Buffer.alloc(0)) === null)

  section('a cache written before the bytes were checked')
  check(
    'a page stored as an icon is not used',
    icons.isUsableIcon(dataUrl('image/x-icon', text('<!doctype html>\n<html lang="zh">'))) === false
  )
  check(
    'a real icon still is',
    icons.isUsableIcon(dataUrl('image/x-icon', bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00))) === true
  )
  check(
    'and so is a real mark that was labelled wrongly',
    icons.isUsableIcon(dataUrl('image/x-icon', bytes(0x89, 0x50, 0x4e, 0x47))) === true
  )
  check('something that is not a data URL is not used', icons.isUsableIcon('https://example.com/i.png') === false)
})
