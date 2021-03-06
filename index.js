const Buffer = require('safe-buffer').Buffer
const EventEmitter = require('events').EventEmitter
const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const pull = require('pull-stream')
const Pushable = require('pull-pushable')
const Reader = require('pull-reader')
const debug = require('debug')
const log = debug('discovery:gossip')
debug.enable('discovery:gossip')

const PROTO = '/discovery/gossip/0.0.0'

module.exports = class handlePeers extends EventEmitter {
  /**
   * @param {Number} targetNumberOfPeers - the max number of peers to add to the peer book
   */
  constructor (targetNumberOfPeers) {
    super()
    this.targetNumberOfPeers = targetNumberOfPeers
    this._onConnection = this._onConnection.bind(this)
  }

  /**
   * Attach an instance of libp2p to the discovery instance
   * @param {Object} node - the libp2p instance
   */
  attach (node) {
    this.node = node
  }

  /**
   * starts the gossip process, this is called by libp2p but if you are using
   * this standalone then this needs to be called
   * @param {Function} cb - a callback
   */
  start (cb) {
    const node = this.node
    node.handle(PROTO, (proto, conn) => {
      const p = Pushable()
      pull(p, conn)

      let peers = peerBookToJson(node.peerBook)

      if (Object.keys(peers).length === 0) {
        p.push(Buffer.from([0]))
      } else {
        peers = Buffer.from(JSON.stringify(peers))
        p.push(Buffer.from([peers.length]))
        p.push(peers)
      }
      p.end()
    })
    this.peerDiscovery(this.targetNumberOfPeers)
    cb()
  }

  /**
   * stop discovery, this is called by libp2p but if you are using
   * this standalone then this needs to be called
   */
  stop () {
    this.node.unhandle(PROTO)
    this.node.removeListener('peer:connect', this._onConnection)
  }

  peerDiscovery (targetNumberOfPeers) {
    const newPeers = this.node.peerBook.getAllArray()
    this._peerDiscovery(this.node, targetNumberOfPeers, newPeers)
    this.node.on('peer:connect', this._onConnection)
  }

  _onConnection (peer) {
    log('connected peer, restarting discovery')
    try {
      const info = this.node.peerBook.get(peer)
      if (!info._askedForPeers) {
        throw new Error()
      }
    } catch (e) {
      this._peerDiscovery(this.node, this.targetNumberOfPeers, [peer])
    }
  }

  _peerDiscovery (node, targetNumberOfPeers, newPeers) {
    if (!node.isStarted()) {
      return
    }

    let knownPeers = node.peerBook.getAllArray()
    if (knownPeers.length < targetNumberOfPeers && newPeers.length !== 0) {
      newPeers.forEach(peer => {
        peer._askedForPeers = true
        node.dial(peer, PROTO, async (err, conn) => {
          if (!node.isStarted()) {
            if (err) {
              node.peerBook.remove(peer)
            }
            return
          }
          if (err) {
            // Remove peers that we cannot connect to
            node.hangUp(peer, () => {
              node.peerBook.remove(peer)
            })
          } else {
            try {
              const peers = await readPeers(node, conn)
              const newPeers = await this.filterPeers(node, peers)
              return this._peerDiscovery(node, targetNumberOfPeers, newPeers)
            } catch (e) {
              // Remove peers that are potentially malicous
              node.hangUp(peer, () => {
                node.peerBook.remove(peer)
                node.emit('error', peer)
              })
            }
          }
        })
      })
    }
  }

  filterPeers (node, peers) {
    const ids = Object.keys(peers)
    const newPeers = []
    ids.forEach(async id => {
      try {
        node.peerBook.get(id)
        log('already have peer ', id)
      } catch (e) {
        const peerId = PeerId.createFromB58String(id)
        const peerInfo = new PeerInfo(peerId)
        const addresses = peers[id]
        addresses.forEach(ad => {
          peerInfo.multiaddrs.add(`${ad}/ipfs/${id}`)
        })
        node.peerBook.put(peerInfo)
        newPeers.push(peerInfo)
        this.emit('peer', peerInfo)
      }
    })
    return newPeers
  }
}

function readPeers (node, conn) {
  const reader = Reader()
  pull(conn, reader)
  return new Promise((resolve, reject) => {
    reader.read(1, (err, len) => {
      if (err) {
        reject(err)
      } else if (len[0] !== 0) {
        reader.read(len[0], (err, data) => {
          if (err) {
            reject(err)
          } else {
            data = data.toString()
            const peers = JSON.parse(data)
            reader.abort()
            resolve(peers)
          }
        })
      } else {
        reader.abort()
        resolve({})
      }
    })
  })
}

function peerBookToJson (peerBook) {
  let peers = {}
  peerBook.getAllArray().forEach(pi => {
    peers[pi.id.toB58String()] = pi.multiaddrs.toArray().map(add => {
      return add.toString().split('/').slice(0, -2).join('/')
    })
  })
  return peers
}
