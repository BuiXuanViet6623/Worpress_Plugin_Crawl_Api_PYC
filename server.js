import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const BASE_URL = 'https://www.writerworking.net';

// --- Crawl danh sách truyện ---
async function getBooks(pageNum = 1) {
    const url = `${BASE_URL}/ben/all/${pageNum}/`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const books = [];
    $('dl').each((i, dl) => {
        if ($(dl).closest('div.right.hidden-xs').length) return;

        const a = $(dl).find('dt a');
        const img = $(dl).find('a.cover img');
        const desc = $(dl).find('dd');
        const bookIdMatch = a.attr('href')?.match(/\/kanshu\/(\d+)\//);

        books.push({
            url: a.attr('href')?.startsWith('http') ? a.attr('href') : BASE_URL + a.attr('href'),
            bookId: bookIdMatch ? bookIdMatch[1] : null,
            title: a.attr('title') || a.text(),
            cover_image: img.attr('data-src') || img.attr('src') || '',
            description: desc.text().trim(),
            chapters: []
        });
    });

    return books;
}

// --- Crawl chi tiết book ---
async function getBookDetail(bookUrl) {
    const { data } = await axios.get(bookUrl);
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
async function getChapters(bookId, numChapters = 5) {
    const url = `${BASE_URL}/xs/${bookId}/1/`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const chapters = [];
    $('div.all ul li').slice(0, numChapters).each((i, li) => {
        const a = $(li).find('a');
        const onclick = a.attr('onclick') || '';
        const match = onclick.match(/location\.href='(.*?)'/);
        const url = match ? BASE_URL + match[1] : null;
        if (url) chapters.push({ url, title: a.text().trim(), content: '' });
    });

    return chapters;
}

// --- Crawl nội dung 1 chương ---
async function getChapterContent(chapterUrl) {
    const { data } = await axios.get(chapterUrl);
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

// --- Giới hạn số request đồng thời ---
async function concurrentMap(items, fn, limit = 10) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            try {
                results[i] = await fn(items[i]);
            } catch (e) {
                results[i] = null;
            }
        }
    }

    const workers = Array.from({ length: limit }, () => worker());
    await Promise.all(workers);
    return results;
}

// --- Crawl cực nhanh ---
app.get('/crawl', async (req, res) => {
    const pageNum = parseInt(req.query.page) || 1;
    const numChapters = parseInt(req.query.num_chapters) || 5;
    const CONCURRENT_LIMIT = 10; // số request đồng thời (tăng để nhanh hơn nếu server chịu được)

    try {
        const books = await getBooks(pageNum);

        // Crawl chi tiết và chapters song song cho tất cả truyện
        await concurrentMap(books, async (book) => {
            if (!book.bookId) return;

            const detail = await getBookDetail(book.url);
            book.author = detail.author;
            book.genres = detail.genres ? [detail.genres] : [];

            const chapters = await getChapters(book.bookId, numChapters);

            // Crawl tất cả chương song song
            book.chapters = await concurrentMap(chapters, async (ch) => {
                const content = await getChapterContent(ch.url);
                return { ...ch, title: content.title, content: content.content };
            }, CONCURRENT_LIMIT);
        }, CONCURRENT_LIMIT);

        res.json({ results: books });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
