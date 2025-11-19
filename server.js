import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import pLimit from 'p-limit';

const app = express();
const BASE_URL = 'https://www.writerworking.net';
const MAX_BOOKS_PER_PAGE = 20;

// Axios instance với keep-alive
const axiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: 20000
});

// --- Crawl danh sách sách ---
async function getBooks(pageNum = 1) {
    const url = `${BASE_URL}/ben/all/${pageNum}/`;
    const { data } = await axiosInstance.get(url);
    const $ = cheerio.load(data);

    const books = [];
    $('dl').each((i, dl) => {
        if (books.length >= MAX_BOOKS_PER_PAGE) return false;
        if ($(dl).closest('div.right.hidden-xs').length) return;

        const a = $(dl).find('dt a');
        const img = $(dl).find('a.cover img');
        const desc = $(dl).find('dd');

        const bookUrl = a.attr('href')?.startsWith('http') ? a.attr('href') : BASE_URL + a.attr('href');

        books.push({
            title: a.attr('title') || a.text(),
            cover_image: img.attr('data-src') || img.attr('src') || '',
            description: desc.text().trim(),
            bookUrl, // chỉ dùng nội bộ crawl chi tiết, sẽ xóa trước khi trả JSON
            author: '',
            genres: [],
            chapters: []
        });
    });

    return books;
}

// --- Crawl chi tiết book ---
async function getBookDetail(bookUrl) {
    const { data } = await axiosInstance.get(bookUrl);
    const $ = cheerio.load(data);

    let author = '';
    let genres = '';

    $('p').each((i, p) => {
        if ($(p).find('b').text().trim() === '作者：') {
            author = $(p).find('a').text().trim();
        }
    });

    const ol = $('ol.container');
    if (ol.find('li').length >= 2) {
        genres = ol.find('li').eq(1).text().trim();
    }

    return { author, genres };
}

// --- Crawl danh sách chương ---
async function getChapters(bookUrl, numChapters = 5) {
    const { data } = await axiosInstance.get(bookUrl);
    const $ = cheerio.load(data);

    const chapters = [];
    $('div.all ul li a').slice(0, numChapters).each((i, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        const chapterUrl = href.startsWith('http') ? href : BASE_URL + href;
        chapters.push({ chapterUrl });
    });

    return chapters;
}

// --- Crawl nội dung 1 chương ---
async function getChapterContent(chapterUrl) {
    const { data } = await axiosInstance.get(chapterUrl);
    const $ = cheerio.load(data);

    const content = $('#booktxthtml p')
        .map((i, p) => $(p).text().trim())
        .get()
        .join('\n');

    let title = $('h1').text().trim();
    if (!title) title = $('title').text().trim();
    title = title.replace(/[\(\（].*?[\)\）]/g, '').trim();

    return { title, content };
}

// --- Concurrent map ---
async function concurrentMap(items, fn, limit = 5) {
    const limiter = pLimit(limit);
    return Promise.all(items.map(item => limiter(() => fn(item))));
}

// --- Route crawl ---
app.get('/crawl', async (req, res) => {
    const pageNum = parseInt(req.query.page) || 1;
    const numChapters = parseInt(req.query.num_chapters) || 5;

    const CONCURRENT_BOOKS = 20;
    const CONCURRENT_CHAPTERS = 10;

    try {
        const books = await getBooks(pageNum);

        await concurrentMap(books, async (book) => {
            // Crawl chi tiết + danh sách chương song song
            const [detail, chapters] = await Promise.all([
                getBookDetail(book.bookUrl),
                getChapters(book.bookUrl, numChapters)
            ]);

            book.author = detail.author;
            book.genres = detail.genres ? [detail.genres] : [];

            // Crawl content từng chương
            book.chapters = await concurrentMap(chapters, async (ch) => {
                const content = await getChapterContent(ch.chapterUrl);
                return { title: content.title, content: content.content };
            }, CONCURRENT_CHAPTERS);

            delete book.bookUrl; // remove URL nội bộ
            book.chapters.forEach(ch => delete ch.chapterUrl); // remove URL chương
        }, CONCURRENT_BOOKS);

        res.json({ results: books });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));
